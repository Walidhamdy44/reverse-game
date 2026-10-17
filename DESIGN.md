# Design direction

The app applies Impeccable’s iOS guidance to a quick shared-phone voice game. The interface feels like a small recording booth: a warm paper backdrop, deep forest ink, a single coral recording action, and a little real audio waveform that makes each player’s voice the visual focus.

## Principles in the interface

- Follow familiar iPhone behavior: safe-area spacing, a portrait layout, readable system type, full-width actions, at least 44-point targets, VoiceOver labels, and room for larger text.
- Keep the first screen focused on one promise and one action. During a round, the current player and step lead the page; the microphone or sound playback gets the center; the next action sits near the bottom.
- Separate the secret word from the handoff experience. The recording screen belongs to the first player, then a full-screen cover gives the next player control.
- Use audio as the decoration: measured recorder levels animate while speaking, and a waveform from each saved recording appears during replay.
- Use restrained opacity and scale feedback on pressed controls. Disable the recorder halo pulse when Reduce Motion is enabled.
- Use local layout direction and Arabic writing direction when the user switches languages; every control remains accessible in both languages.

Avoid gradient-heavy backgrounds, repeated floating cards, novelty emoji icons, and motion that hides what a control is doing.

## References

- [Impeccable README](https://github.com/pbakaus/impeccable)
- [Impeccable iOS guidance](https://github.com/pbakaus/impeccable/blob/main/.agent/skills/impeccable/reference/ios.md)
- [Impeccable layout guidance](https://github.com/pbakaus/impeccable/blob/main/.agent/skills/impeccable/reference/layout.md)
- [React Native layout direction](https://reactnative.dev/docs/layout-props#direction)
