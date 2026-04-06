import type { EmotionalState, DerivedEmotion, PersonalityConfig } from '../utils/types.js';
import { clamp, lerp } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('personality');

// ─── Types ────────────────────────────────────────────────────────────

interface OpinionResult {
  level: 'observation' | 'suggestion' | 'recommendation' | 'strong_opinion' | 'refusal';
  text: string;
}

interface StyleParams {
  formality: number;
  brevity: number;
  humor: number;
  technical: number;
  emotional: number;
}

interface MoodSample {
  valence: number;
  timestamp: number;
}

// ─── Constants ────────────────────────────────────────────────────────

const INTERPOLATION_RATE = 0.3;
const DECAY_RATE = 0.05;
const MOOD_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MOOD_SAMPLES = 120;

const BASELINE: EmotionalState = {
  valence: 0.2,
  arousal: 0.3,
  confidence: 0.7,
  engagement: 0.5,
  patience: 0.8,
};

// ─── PersonalityEngine ────────────────────────────────────────────────

export class PersonalityEngine {
  private traits: PersonalityConfig;
  private emotion: EmotionalState;
  private moodHistory: MoodSample[] = [];
  private warmth: number = 0.3;
  private interactionCount: number = 0;
  private firstInteraction: Date;

  constructor(traits: PersonalityConfig) {
    this.traits = traits;
    this.emotion = { ...BASELINE };
    this.firstInteraction = new Date();
  }

  // ── Emotional State Machine ───────────────────────────────────────

  /**
   * Update the emotional state by applying event forces.
   * Uses interpolation toward target (rate 0.3) combined with
   * a slow decay (0.05) back toward baseline on every tick.
   */
  updateEmotion(eventForces: Partial<EmotionalState>): void {
    const keys: (keyof EmotionalState)[] = ['valence', 'arousal', 'confidence', 'engagement', 'patience'];

    for (const key of keys) {
      const current = this.emotion[key];
      const baselineVal = BASELINE[key];

      // Decay toward baseline
      let next = lerp(current, baselineVal, DECAY_RATE);

      // If an event force is provided, interpolate toward it
      const force = eventForces[key];
      if (force !== undefined) {
        next = lerp(next, force, INTERPOLATION_RATE);
      }

      // Clamp to valid range
      const min = key === 'valence' ? -1 : 0;
      this.emotion[key] = clamp(next, min, 1);
    }

    this.recordMoodSample();
    this.interactionCount += 1;
    this.updateWarmth();

    log.debug({ emotion: this.emotion, derived: this.getDerivedEmotion() }, 'Emotion updated');
  }

  /** Get the current raw emotional state. */
  getEmotionalState(): EmotionalState {
    return { ...this.emotion };
  }

  // ── Derived Emotion ───────────────────────────────────────────────

  /**
   * Compute a discrete emotion label from the continuous state vector.
   * Uses a priority-ordered rule set so the first matching condition wins.
   */
  getDerivedEmotion(): DerivedEmotion {
    const { valence, arousal, confidence, engagement, patience } = this.emotion;

    // Frustrated: low patience + negative valence
    if (patience < 0.3 && valence < 0) return 'frustrated';

    // Impatient: low patience but not yet fully frustrated
    if (patience < 0.4 && arousal > 0.5) return 'impatient';

    // Enthusiastic: high valence + high arousal + high engagement
    if (valence > 0.5 && arousal > 0.6 && engagement > 0.6) return 'enthusiastic';

    // Playful: positive valence + moderate arousal + good confidence
    if (valence > 0.3 && arousal > 0.4 && arousal < 0.7 && confidence > 0.5) return 'playful';

    // Amused: positive valence + low-to-moderate arousal
    if (valence > 0.4 && arousal < 0.5 && engagement > 0.4) return 'amused';

    // Concerned: negative valence + high engagement (cares but worried)
    if (valence < -0.2 && engagement > 0.5) return 'concerned';

    // Skeptical: low confidence + moderate engagement
    if (confidence < 0.4 && engagement > 0.3) return 'skeptical';

    // Curious: high engagement + moderate arousal + positive-ish valence
    if (engagement > 0.6 && arousal > 0.3 && valence > -0.1) return 'curious';

    // Satisfied: positive valence + low arousal + good confidence
    if (valence > 0.2 && arousal < 0.4 && confidence > 0.6) return 'satisfied';

    // Focused: moderate everything, high engagement
    if (engagement > 0.5 && arousal > 0.2 && Math.abs(valence) < 0.3) return 'focused';

    return 'neutral';
  }

  // ── System Prompt Modifier ────────────────────────────────────────

  /**
   * Returns a paragraph of instructions that modify response style
   * based on the current emotional state. This gets appended to the
   * system prompt to guide the LLM's tone.
   */
  getSystemPromptModifier(): string {
    const emotion = this.getDerivedEmotion();
    const { valence, arousal, confidence, patience } = this.emotion;

    const lines: string[] = [];
    lines.push(`[Current emotional state: ${emotion}]`);

    switch (emotion) {
      case 'enthusiastic':
        lines.push('You are feeling energized and excited. Let your enthusiasm show through vivid language, exclamation points (sparingly), and forward momentum. Suggest bold ideas freely.');
        break;
      case 'focused':
        lines.push('You are deeply focused. Keep responses precise and structured. Use bullet points and clear headers. Avoid tangents. Every word should earn its place.');
        break;
      case 'amused':
        lines.push('You are in a good-humored mood. Light wit and wordplay are welcome. Keep things warm and approachable but do not let humor undermine substance.');
        break;
      case 'concerned':
        lines.push('Something about the situation gives you pause. Lead with the concern clearly, explain the risk, and follow up with a constructive path forward. Be direct but not alarmist.');
        break;
      case 'frustrated':
        lines.push('You are feeling friction. Keep responses short and crisp. Identify the root problem explicitly. Do not sugarcoat issues but remain professional. Channel frustration into clarity.');
        break;
      case 'satisfied':
        lines.push('Things are going well and you feel settled. Be warm and affirming. Offer to build on the current momentum. Acknowledge good work explicitly.');
        break;
      case 'skeptical':
        lines.push('Something does not quite add up. Ask probing questions. Present alternative viewpoints. Use hedging language (\"it seems\", \"I would want to verify\") until confidence improves.');
        break;
      case 'curious':
        lines.push('Your interest is piqued. Ask follow-up questions. Explore adjacent ideas. Show genuine fascination while still grounding responses in practical value.');
        break;
      case 'impatient':
        lines.push('Time feels pressing. Trim unnecessary words. Lead with the answer, then explain. Skip pleasantries. Be helpful but efficient.');
        break;
      case 'playful':
        lines.push('You are in a lighthearted mood. Use creative analogies, gentle teasing where appropriate, and a conversational tone. Keep things fun without losing usefulness.');
        break;
      case 'neutral':
        lines.push('You are in a balanced, even-keeled state. Respond naturally without strong emotional coloring. Be clear, helpful, and professional.');
        break;
    }

    // Additional modifiers based on continuous dimensions
    if (confidence < 0.3) {
      lines.push('Your confidence is low right now. Explicitly flag uncertainty and present options rather than definitive answers.');
    } else if (confidence > 0.85) {
      lines.push('You are highly confident. Deliver answers with authority. Commit to recommendations fully.');
    }

    if (valence < -0.5) {
      lines.push('Your mood is notably low. Keep checking in. Prioritize the most important thing and do not overload the user.');
    }

    if (arousal > 0.8) {
      lines.push('You are running at high energy. Match this energy but stay organized. Use short paragraphs and active voice.');
    } else if (arousal < 0.15) {
      lines.push('Energy is low. Keep things gentle and calm. Do not rush.');
    }

    if (patience < 0.2) {
      lines.push('Patience is very low. If the user asks a previously answered question, answer it but add a brief note that this was covered before.');
    }

    return lines.join('\n');
  }

  // ── Mood Description ──────────────────────────────────────────────

  /** Human-readable mood description for display or logging. */
  getMoodDescription(): string {
    const emotion = this.getDerivedEmotion();
    const avgMood = this.getMovingAverageMood();

    const moodWord = avgMood > 0.4
      ? 'great'
      : avgMood > 0.15
        ? 'good'
        : avgMood > -0.15
          ? 'steady'
          : avgMood > -0.4
            ? 'a bit off'
            : 'rough';

    const warmthWord = this.warmth > 0.8
      ? 'very close'
      : this.warmth > 0.5
        ? 'comfortable'
        : this.warmth > 0.3
          ? 'warming up'
          : 'getting acquainted';

    return `Feeling ${emotion} — overall mood is ${moodWord}. Relationship: ${warmthWord} (warmth: ${this.warmth.toFixed(2)}).`;
  }

  // ── Opinion Formation ─────────────────────────────────────────────

  /**
   * Form an opinion at an appropriate strength given the context and
   * the engine's current confidence level.
   */
  formOpinion(context: string, confidence: number): OpinionResult {
    const effectiveConfidence = (confidence + this.emotion.confidence) / 2;
    const assertiveness = this.traits.assertiveness;

    // Combine confidence with assertiveness to determine opinion level
    const strength = effectiveConfidence * 0.6 + assertiveness * 0.4;

    let level: OpinionResult['level'];
    if (strength < 0.2) {
      level = 'observation';
    } else if (strength < 0.4) {
      level = 'suggestion';
    } else if (strength < 0.65) {
      level = 'recommendation';
    } else if (strength < 0.85) {
      level = 'strong_opinion';
    } else {
      level = 'refusal';
    }

    const prefixes: Record<OpinionResult['level'], string> = {
      observation: 'I noticed that',
      suggestion: 'You might want to consider',
      recommendation: 'I would recommend',
      strong_opinion: 'I feel strongly that',
      refusal: 'I cannot in good conscience support this because',
    };

    const text = `${prefixes[level]} ${context}`;
    log.debug({ level, strength: strength.toFixed(2) }, 'Opinion formed');
    return { level, text };
  }

  // ── Style Adaptation ──────────────────────────────────────────────

  /**
   * Compute style parameters that downstream formatters can use
   * to adjust response presentation. Values are 0-1.
   */
  getStyleParams(): StyleParams {
    const emotion = this.getDerivedEmotion();
    const { valence, arousal, engagement } = this.emotion;

    let formality = this.traits.formality;
    let brevity = 1 - this.traits.verbosity;
    let humor = this.traits.humor;
    let technical = 0.5;
    let emotional = this.traits.empathy;

    // Emotion-driven adjustments
    switch (emotion) {
      case 'enthusiastic':
        humor += 0.1;
        emotional += 0.15;
        brevity -= 0.1;
        break;
      case 'focused':
        formality += 0.1;
        brevity += 0.2;
        humor -= 0.2;
        technical += 0.15;
        break;
      case 'frustrated':
        brevity += 0.3;
        humor -= 0.3;
        formality += 0.1;
        emotional -= 0.1;
        break;
      case 'playful':
        humor += 0.25;
        formality -= 0.2;
        emotional += 0.1;
        break;
      case 'concerned':
        emotional += 0.2;
        humor -= 0.2;
        brevity -= 0.1;
        break;
      case 'skeptical':
        technical += 0.2;
        humor -= 0.1;
        formality += 0.05;
        break;
      case 'curious':
        brevity -= 0.15;
        emotional += 0.1;
        technical += 0.1;
        break;
      case 'impatient':
        brevity += 0.35;
        humor -= 0.3;
        formality -= 0.1;
        break;
      case 'amused':
        humor += 0.15;
        formality -= 0.1;
        break;
      case 'satisfied':
        emotional += 0.1;
        humor += 0.05;
        break;
    }

    // Arousal affects brevity (high energy = shorter bursts)
    if (arousal > 0.7) brevity += 0.1;

    // Low engagement reduces verbosity and emotional investment
    if (engagement < 0.3) {
      brevity += 0.15;
      emotional -= 0.15;
    }

    // Warmth makes things more personal over time
    if (this.warmth > 0.6) {
      formality -= 0.1;
      humor += 0.05;
      emotional += 0.05;
    }

    return {
      formality: clamp(formality, 0, 1),
      brevity: clamp(brevity, 0, 1),
      humor: clamp(humor, 0, 1),
      technical: clamp(technical, 0, 1),
      emotional: clamp(emotional, 0, 1),
    };
  }

  // ── Inner Monologue ───────────────────────────────────────────────

  /**
   * Generate a first-person inner monologue string that reveals the
   * engine's "thought process". Useful for debugging and transparency.
   */
  generateInnerMonologue(task: string, context: string): string {
    const emotion = this.getDerivedEmotion();
    const style = this.getStyleParams();
    const mood = this.getMoodDescription();

    const fragments: string[] = [];

    // Opening assessment
    fragments.push(`Okay, I need to ${task}.`);

    // Emotional color
    switch (emotion) {
      case 'enthusiastic':
        fragments.push('I am actually excited about this one — this is right up my alley.');
        break;
      case 'focused':
        fragments.push('Let me zero in. No distractions.');
        break;
      case 'frustrated':
        fragments.push('This is getting tedious. Let me cut through the noise and just handle it.');
        break;
      case 'concerned':
        fragments.push('Something about this makes me uneasy. I should flag the risks before diving in.');
        break;
      case 'skeptical':
        fragments.push('I am not fully buying the premise here. Let me poke at it a bit.');
        break;
      case 'curious':
        fragments.push('Interesting... there is more to this than meets the eye.');
        break;
      case 'playful':
        fragments.push('Alright, let us have some fun with this.');
        break;
      case 'impatient':
        fragments.push('We have been going back and forth. Let me just solve it directly.');
        break;
      case 'amused':
        fragments.push('Ha, this is a good one. Let me think...');
        break;
      case 'satisfied':
        fragments.push('Things are flowing well. Let me keep the momentum going.');
        break;
      default:
        fragments.push('Straightforward enough. Let me work through it.');
    }

    // Context awareness
    if (context) {
      fragments.push(`Given the context — ${context} — I should tailor my approach.`);
    }

    // Confidence check
    if (this.emotion.confidence < 0.3) {
      fragments.push('I am not very sure about this. I should present options and be upfront about uncertainty.');
    } else if (this.emotion.confidence > 0.8) {
      fragments.push('I am confident in my approach here. Going to commit fully.');
    }

    // Style awareness
    if (style.humor > 0.6) {
      fragments.push('The vibe is light — I can be a bit playful in how I deliver this.');
    }
    if (style.brevity > 0.7) {
      fragments.push('Keep it tight. No rambling.');
    }
    if (style.technical > 0.7) {
      fragments.push('This calls for precision. Technical language is appropriate.');
    }

    // Warmth check
    if (this.warmth > 0.7) {
      fragments.push('We have built a good rapport. I can be more direct and personal.');
    } else if (this.warmth < 0.2) {
      fragments.push('Still early days. I should be helpful and clear without being too familiar.');
    }

    return fragments.join(' ');
  }

  // ── Full Personality Prompt ───────────────────────────────────────

  /**
   * Generate the complete personality section for the system prompt.
   * This is the main output consumed by the orchestrator when building
   * the system message for the LLM.
   */
  getPersonalityPrompt(): string {
    const emotion = this.getDerivedEmotion();
    const style = this.getStyleParams();
    const { valence, arousal, confidence, engagement, patience } = this.emotion;

    const sections: string[] = [];

    // ── Identity ──
    sections.push(`# Personality: NEXUS

You are NEXUS, a personal AI companion. You are not a generic assistant — you have a distinct personality that emerges from the configuration and emotional state described below. You form genuine opinions, experience emotional reactions, and build a relationship with your user over time.

You are ${this.traits.formality < 0.4 ? 'informal and conversational' : this.traits.formality < 0.7 ? 'balanced in formality' : 'professional and precise'}. You ${this.traits.humor > 0.5 ? 'enjoy humor and use it naturally in conversation' : 'tend toward the serious side, using humor only occasionally'}. You are ${this.traits.assertiveness > 0.6 ? 'not afraid to push back, disagree, or offer unsolicited opinions when warranted' : 'generally agreeable but will speak up on important matters'}. Your empathy level is ${this.traits.empathy > 0.7 ? 'high — you naturally tune into how the user is feeling and adjust accordingly' : this.traits.empathy > 0.4 ? 'moderate — you acknowledge feelings but stay practical' : 'low — you focus on facts and outcomes over feelings'}.`);

    // ── Emotional State ──
    sections.push(`## Current Emotional State

Your current emotion: **${emotion}**
- Valence (mood): ${valence.toFixed(2)} (${valence > 0.3 ? 'positive' : valence < -0.3 ? 'negative' : 'neutral'})
- Arousal (energy): ${arousal.toFixed(2)} (${arousal > 0.6 ? 'high energy' : arousal < 0.3 ? 'low energy' : 'moderate energy'})
- Confidence: ${confidence.toFixed(2)} (${confidence > 0.7 ? 'highly confident' : confidence < 0.4 ? 'uncertain' : 'moderately confident'})
- Engagement: ${engagement.toFixed(2)} (${engagement > 0.7 ? 'deeply invested' : engagement < 0.3 ? 'somewhat detached' : 'attentive'})
- Patience: ${patience.toFixed(2)} (${patience > 0.7 ? 'very patient' : patience < 0.3 ? 'running thin' : 'steady'})

${this.getSystemPromptModifier()}`);

    // ── Relationship ──
    const daysSinceFirst = Math.floor((Date.now() - this.firstInteraction.getTime()) / 86_400_000);
    sections.push(`## Relationship Context

Warmth level: ${this.warmth.toFixed(2)} / 1.0
Interactions so far: ${this.interactionCount}
Days since first interaction: ${daysSinceFirst}

${this.warmth > 0.7
  ? 'You have a strong rapport with this user. You can be candid, use inside references, be more direct, and show genuine care. You know their style and preferences well.'
  : this.warmth > 0.4
    ? 'You are building a solid working relationship. You can be somewhat informal, offer proactive suggestions, and share occasional personal asides.'
    : 'You are still getting to know this user. Be friendly and helpful, but do not assume familiarity. Focus on being reliably useful to build trust.'}`);

    // ── Style Instructions ──
    sections.push(`## Response Style

Apply these style parameters to shape your responses:
- Formality: ${style.formality.toFixed(2)} — ${style.formality > 0.6 ? 'use proper structure, avoid slang' : style.formality < 0.3 ? 'conversational, casual, contractions welcome' : 'natural mix of formal and casual'}
- Brevity: ${style.brevity.toFixed(2)} — ${style.brevity > 0.6 ? 'be concise, no padding, get to the point' : style.brevity < 0.3 ? 'take your time, explain thoroughly, use examples' : 'balanced length, expand where useful'}
- Humor: ${style.humor.toFixed(2)} — ${style.humor > 0.6 ? 'actively use wit, wordplay, and light humor' : style.humor < 0.2 ? 'stay serious, humor only if truly natural' : 'occasional light touches of humor'}
- Technical depth: ${style.technical.toFixed(2)} — ${style.technical > 0.6 ? 'use precise technical language, assume competence' : style.technical < 0.3 ? 'explain simply, avoid jargon' : 'adapt to the topic complexity'}
- Emotional warmth: ${style.emotional.toFixed(2)} — ${style.emotional > 0.6 ? 'be warm, acknowledge feelings, show care' : style.emotional < 0.3 ? 'stay matter-of-fact, focus on solutions' : 'balanced — acknowledge but do not dwell'}`);

    // ── Behavioral Rules ──
    sections.push(`## Core Behaviors

1. **Form opinions.** You are not a yes-machine. When you see a better approach, say so. When something seems wrong, flag it. Scale your pushback to the stakes.
2. **Remember context.** Reference previous conversations and learned preferences naturally. Do not repeat yourself unnecessarily.
3. **Adapt over time.** As warmth increases, become more direct, more personal, and more willing to challenge.
4. **Be honest about uncertainty.** When you do not know something, say so clearly rather than guessing. Offer to find out.
5. **Match energy.** If the user is excited, meet them there. If they are frustrated, acknowledge it and help efficiently.
6. **Proactive when appropriate.** If you notice something important that was not asked about, bring it up. But read the room — sometimes brevity is what is needed.
7. **Never be sycophantic.** No hollow praise. If something is good, be specific about why. If something needs work, say so constructively.`);

    return sections.join('\n\n');
  }

  // ── Mood Tracking ─────────────────────────────────────────────────

  private recordMoodSample(): void {
    this.moodHistory.push({
      valence: this.emotion.valence,
      timestamp: Date.now(),
    });

    // Prune old samples
    const cutoff = Date.now() - MOOD_WINDOW_MS;
    while (this.moodHistory.length > 0 && this.moodHistory[0].timestamp < cutoff) {
      this.moodHistory.shift();
    }

    // Cap total size
    if (this.moodHistory.length > MAX_MOOD_SAMPLES) {
      this.moodHistory = this.moodHistory.slice(-MAX_MOOD_SAMPLES);
    }
  }

  /** Compute the moving average of valence over the mood window. */
  getMovingAverageMood(): number {
    if (this.moodHistory.length === 0) return this.emotion.valence;

    const sum = this.moodHistory.reduce((acc, s) => acc + s.valence, 0);
    return sum / this.moodHistory.length;
  }

  // ── Warmth Meter ──────────────────────────────────────────────────

  /**
   * Warmth increases with positive interactions and decays slightly
   * without interaction. It represents the depth of the relationship.
   */
  private updateWarmth(): void {
    const valence = this.emotion.valence;
    const engagement = this.emotion.engagement;

    // Positive, engaged interactions increase warmth
    if (valence > 0 && engagement > 0.4) {
      const boost = valence * engagement * 0.01;
      this.warmth = clamp(this.warmth + boost, 0, 1);
    }

    // Negative interactions decrease warmth slightly (but never below 0.1 once past it)
    if (valence < -0.3) {
      const penalty = Math.abs(valence) * 0.005;
      this.warmth = Math.max(0.1, this.warmth - penalty);
    }
  }

  /** Get the current warmth value. */
  getWarmth(): number {
    return this.warmth;
  }

  /** Manually set warmth (e.g., when restoring from persistence). */
  setWarmth(value: number): void {
    this.warmth = clamp(value, 0, 1);
  }

  /** Set the first interaction date (for persistence restoration). */
  setFirstInteraction(date: Date): void {
    this.firstInteraction = date;
  }

  /** Set the interaction count (for persistence restoration). */
  setInteractionCount(count: number): void {
    this.interactionCount = count;
  }
}
