// NEXUS wake-word listener — always-on, on-device, local. No keys, no network.
//
// Continuously recognizes microphone audio with Apple's Speech framework
// (on-device when available) and prints "WAKE" to stdout when it hears the
// phrase "Hey Nexus". The NEXUS daemon supervises this process and, on WAKE,
// opens / focuses the Jarvis UI and tells the page to start listening.
//
// Privacy: with on-device recognition, audio never leaves the machine and the
// daemon only ever receives the literal token "WAKE" — never your speech.
//
// Build (see scripts / package.json build:wake):
//   swiftc -O -swift-version 5 main.swift -o nexus-wake \
//     -framework Speech -framework AVFoundation \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist

import Foundation
import AVFoundation
import Speech

setbuf(stdout, nil) // unbuffered: WAKE reaches the parent immediately

func err(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

final class WakeListener: NSObject {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lastWake = Date.distantPast
    private var restarting = false
    private var generation = 0 // bumps each recognition cycle; stale callbacks are ignored
    private var restartTimer: Timer?

    private let prefixes = ["hey", "hay", "hi", "ok", "okay", "a", "yo"]
    private let names = ["nexus", "lexus", "nexis", "nexius", "nexa", "nexar", "nektos", "necks us", "next us", "nexuses"]
    // Partial stems: fire the moment "hey ne…/nex…/next" shows up in a partial,
    // before the dictation engine fully commits "nexus". Biased for recall (catch
    // fast/quiet speech the first time); the 4s debounce suppresses doubles.
    private let nameStems = ["nex", "neks", "necks", "lex", "next", "nehk"]

    // After "Hey Nexus" fires, we keep transcribing to capture the spoken command.
    private var capturing = false
    private var captureStart = Date.distantPast
    private var commandText = ""
    private var captureWatchdog: Timer?
    private var lastPartialChange = Date.distantPast
    // Emit the command after this much post-speech silence instead of waiting for
    // SFSpeech's slow isFinal trailing-silence. Tunable via NEXUS_WAKE_SILENCE_MS.
    private let silenceTimeout: TimeInterval =
        (ProcessInfo.processInfo.environment["NEXUS_WAKE_SILENCE_MS"].flatMap { Double($0) }.map { $0 / 1000.0 }) ?? 0.7
    private let minCaptureBeforeEmit: TimeInterval = 0.4
    // Set NEXUS_WAKE_DEBUG=1 to log every partial transcript to stderr.
    private let debug = ProcessInfo.processInfo.environment["NEXUS_WAKE_DEBUG"] != nil

    // ── KWS wake engine (sherpa-onnx) — the real, instant wake detector ──────────
    // Raw mic PCM is piped to a resident Python KeywordSpotter that fires on the
    // acoustic match for "hey nexus" the instant it's spoken (no dictation commit
    // needed). SFSpeech stays as command-capture + a wake fallback, so if the KWS
    // isn't installed or fails to start, behavior degrades to today's SFSpeech path.
    private var kwsProc: Process?
    private var kwsStdin: FileHandle?
    private var kwsConverter: AVAudioConverter?
    private var kwsOutFormat: AVAudioFormat?
    private let kwsQueue = DispatchQueue(label: "ai.nexus.kws.write")

    func authorizeAndStart() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else {
                err("FATAL speech-recognition not authorized (status \(status.rawValue))")
                exit(5)
            }
            let mic = AVCaptureDevice.authorizationStatus(for: .audio)
            switch mic {
            case .authorized:
                DispatchQueue.main.async { self?.start() }
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    if ok { DispatchQueue.main.async { self?.start() } }
                    else { err("FATAL microphone access denied"); exit(6) }
                }
            default:
                err("FATAL microphone not authorized (status \(mic.rawValue))")
                exit(6)
            }
        }
    }

    private func start() {
        guard let recognizer = recognizer, recognizer.isAvailable else {
            err("FATAL speech recognizer unavailable for en-US")
            exit(3)
        }
        if !recognizer.supportsOnDeviceRecognition {
            err("WARN on-device recognition unavailable — falling back to network recognition")
        }
        begin()
        startKWS() // the instant acoustic wake detector; SFSpeech remains as fallback + command capture
        // Apple caps a single recognition request (~1 min of audio); cycle it —
        // but never mid-command-capture.
        restartTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if !self.capturing { self.restart() }
        }
        // Emit the command as soon as the user pauses (transcript stable for a
        // short window) instead of waiting for SFSpeech's slow isFinal. Hard cap
        // at 8s so a trailing-off capture never hangs.
        captureWatchdog = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self = self, self.capturing else { return }
            let now = Date()
            let sinceStart = now.timeIntervalSince(self.captureStart)
            let sinceWord = now.timeIntervalSince(self.lastPartialChange)
            let haveWords = !self.commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if haveWords && sinceWord >= self.silenceTimeout && sinceStart >= self.minCaptureBeforeEmit {
                self.emitCommand()
                self.restart()
                return
            }
            if sinceStart > 8 {
                self.emitCommand()
                self.restart()
            }
        }
        err("READY listening for \"Hey Nexus\"")
    }

    private func begin() {
        startAudio()
        beginRecognition()
    }

    // Install the mic tap + start the engine ONCE. The tap appends to whatever
    // `request` currently is, so we can swap the recognition request without ever
    // tearing the audio engine down — that teardown gap dropped the post-wake command.
    private func startAudio() {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
            self?.feedKWS(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            err("FATAL audio engine failed to start: \(error.localizedDescription)")
            exit(4)
        }
    }

    private func beginRecognition() {
        guard let recognizer = recognizer else { return }
        generation += 1
        let gen = generation
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .unspecified // .confirmation finalized too early and cut off the command
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        req.contextualStrings = ["Hey Nexus", "Nexus", "hey nexus", "OK Nexus"]
        request = req

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self, gen == self.generation else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                let lower = text.lowercased()
                if self.debug && !text.isEmpty { err("heard: \(text)") }
                if !self.capturing && self.matches(lower) {
                    if self.fire() {
                        self.capturing = true
                        self.captureStart = Date()
                        self.lastPartialChange = Date()
                    }
                }
                if self.capturing {
                    let newCmd = self.extractCommand(text)
                    if newCmd != self.commandText {
                        self.commandText = newCmd
                        self.lastPartialChange = Date() // words still arriving
                    }
                }
                if result.isFinal {
                    if self.capturing { self.emitCommand() }
                    self.restart()
                    return
                }
            }
            if error != nil {
                if self.capturing { self.emitCommand() }
                self.restart()
            }
        }
    }

    private func matches(_ text: String) -> Bool {
        if text.contains("hey nexus") { return true }
        for p in prefixes {
            for n in names where text.contains("\(p) \(n)") {
                return true
            }
            for s in nameStems where text.contains("\(p) \(s)") {
                return true
            }
        }
        return false
    }

    private func fire() -> Bool {
        let now = Date()
        if now.timeIntervalSince(lastWake) < 4 { return false } // debounce
        lastWake = now
        print("WAKE")
        return true
    }

    // Shared wake trigger (called by both the KWS engine and the SFSpeech matcher).
    private func triggerWake() {
        guard !capturing else { return }
        if fire() {
            capturing = true
            captureStart = Date()
            lastPartialChange = Date()
        }
    }

    // Spawn the resident sherpa-onnx KeywordSpotter and wire its WAKE output to the
    // wake trigger. Fully optional: if the venv/worker/model are missing or the
    // process fails to launch, we stay on the SFSpeech wake path.
    private func startKWS() {
        if ProcessInfo.processInfo.environment["NEXUS_WAKE_KWS"] == "0" { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let python = "\(home)/.nexus/tts-venv/bin/python"
        let worker = "\(home)/.nexus/wake/kws_worker.py"
        let fm = FileManager.default
        guard fm.fileExists(atPath: python), fm.fileExists(atPath: worker) else {
            err("KWS not installed — SFSpeech wake only")
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: python)
        proc.arguments = [worker]
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let s = String(decoding: h.availableData, as: UTF8.self)
            if s.contains("WAKE") {
                DispatchQueue.main.async { self?.triggerWake() }
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let s = String(decoding: h.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if !s.isEmpty { err("kws: \(s)") }
        }
        proc.terminationHandler = { [weak self] _ in
            self?.kwsStdin = nil
            self?.kwsProc = nil
        }
        do {
            try proc.run()
            kwsProc = proc
            kwsStdin = inPipe.fileHandleForWriting
            err("KWS wake engine started")
        } catch {
            err("KWS spawn failed (\(error.localizedDescription)) — SFSpeech wake only")
        }
    }

    // Convert a mic buffer to 16 kHz mono int16 and feed it to the KWS worker.
    private func feedKWS(_ buffer: AVAudioPCMBuffer) {
        guard kwsStdin != nil else { return }
        if kwsConverter == nil {
            guard let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
                  let conv = AVAudioConverter(from: buffer.format, to: outFmt) else { return }
            kwsConverter = conv
            kwsOutFormat = outFmt
        }
        guard let conv = kwsConverter, let outFmt = kwsOutFormat else { return }
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * 16000.0 / buffer.format.sampleRate) + 64
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
        var nsErr: NSError?
        var fed = false
        conv.convert(to: outBuf, error: &nsErr) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if nsErr != nil { return }
        if let ch = outBuf.int16ChannelData, outBuf.frameLength > 0 {
            let data = Data(bytes: ch[0], count: Int(outBuf.frameLength) * 2)
            kwsQueue.async { [weak self] in self?.kwsStdin?.write(data) }
        }
    }

    // Everything the user said after the wake phrase, as the command.
    private func extractCommand(_ text: String) -> String {
        let lower = text.lowercased()
        guard let r = lower.range(of: "nexus") else { return "" }
        let offset = lower.distance(from: lower.startIndex, to: r.upperBound)
        let idx = text.index(text.startIndex, offsetBy: offset)
        return String(text[idx...]).trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?\n\t"))
    }

    private func emitCommand() {
        let cmd = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cmd.isEmpty { print("CMD:\(cmd)") }
        capturing = false
        commandText = ""
    }

    private func restart() {
        if restarting { return }
        restarting = true
        let oldTask = task
        let oldReq = request
        oldTask?.cancel()
        // Leave `request` pointing at the (now task-less) old request so the mic
        // tap never appends to nil — no audio gap where a wake word is dropped.
        // Swap to a fresh recognition on the next tick (so we don't create a task
        // from inside the old task's completion handler). The generation guard
        // makes the cancelled task's late callbacks no-ops.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.beginRecognition()
            oldReq?.endAudio()
            self.restarting = false
        }
    }
}

// --check: report current authorization WITHOUT prompting (used by the
// installer's permission checklist). Exit 0 only if Speech + Mic are authorized.
if CommandLine.arguments.contains("--check") {
    let speechOK = SFSpeechRecognizer.authorizationStatus() == .authorized
    let micOK = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    exit(speechOK && micOK ? 0 : 1)
}

let listener = WakeListener()
listener.authorizeAndStart()
RunLoop.main.run()
