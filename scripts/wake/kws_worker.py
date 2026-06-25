#!/usr/bin/env python3
# NEXUS wake-word KWS worker — sherpa-onnx KeywordSpotter (on-device, no key).
#
# This is the REAL wake detector: it scores raw audio acoustically for "hey
# nexus" instead of waiting for a dictation engine to fully transcribe it, so it
# fires instantly on the first utterance even when fast/quiet/slurred. It reads
# raw 16 kHz mono int16 PCM from stdin (the Swift mic front-end pipes it in) and
# prints "WAKE" to stdout the moment the keyword is spotted. Privacy is preserved:
# nothing but "WAKE" ever leaves this process.
import sys
import os

import numpy as np
import sherpa_onnx

DIR = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get(
    "NEXUS_KWS_MODEL",
    os.path.join(DIR, "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"),
)
KEYWORDS = os.environ.get("NEXUS_KWS_KEYWORDS", os.path.join(MODEL, "hey_nexus.txt"))
SAMPLE_RATE = 16000


def main() -> None:
    try:
        spotter = sherpa_onnx.KeywordSpotter(
            tokens=os.path.join(MODEL, "tokens.txt"),
            encoder=os.path.join(MODEL, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
            decoder=os.path.join(MODEL, "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
            joiner=os.path.join(MODEL, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
            keywords_file=KEYWORDS,
            num_threads=1,
            provider=os.environ.get("NEXUS_KWS_PROVIDER", "cpu"),
            max_active_paths=4,
            keywords_score=float(os.environ.get("NEXUS_KWS_SCORE", "2.5")),
            keywords_threshold=float(os.environ.get("NEXUS_KWS_THRESHOLD", "0.08")),
            num_trailing_blanks=1,
        )
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"FATAL could not load KWS model: {exc}\n")
        sys.stderr.flush()
        sys.exit(2)

    stream = spotter.create_stream()
    sys.stderr.write("READY\n")
    sys.stderr.flush()

    chunk_bytes = 3200  # 0.1 s @ 16 kHz, int16 (1600 samples * 2 bytes)
    # Optional audio-level readout (set NEXUS_KWS_DEBUG=1 to enable). Off by default so
    # it doesn't spam the log. rms ~0 every time = no audio reaching the KWS (Swift
    # mic→pipe issue); a level with no WAKE = a detection/threshold problem.
    debug = os.environ.get("NEXUS_KWS_DEBUG") not in (None, "", "0")
    n = 0
    peak = 0.0
    while True:
        data = sys.stdin.buffer.read(chunk_bytes)
        if not data:
            break
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        if debug:
            if samples.size:
                peak = max(peak, float(np.sqrt(np.mean(samples**2))))
            n += 1
            if n % 30 == 0:  # ~every 3 s
                sys.stderr.write(f"level peakRms={peak:.4f}\n")
                sys.stderr.flush()
                peak = 0.0
        stream.accept_waveform(SAMPLE_RATE, samples)
        while spotter.is_ready(stream):
            spotter.decode_stream(stream)
        result = spotter.get_result(stream)
        if result:
            sys.stdout.write("WAKE\n")
            sys.stdout.flush()
            spotter.reset_stream(stream)


if __name__ == "__main__":
    main()
