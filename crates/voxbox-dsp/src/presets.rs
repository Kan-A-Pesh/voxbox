use crate::{EffectKind, EffectSpec, VoiceCategory, VoicePreset};

fn effect(kind: EffectKind, params: &[(&str, f32)]) -> EffectSpec {
    EffectSpec {
        kind,
        params: params.iter().map(|(k, v)| ((*k).into(), *v)).collect(),
        enabled: true,
    }
}

fn voice(
    id: &str,
    name: &str,
    description: &str,
    icon: &str,
    color: &str,
    category: VoiceCategory,
    effects: Vec<EffectSpec>,
) -> VoicePreset {
    VoicePreset {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        icon: icon.into(),
        color: color.into(),
        category,
        effects,
        ai_model_id: None,
        builtin: true,
    }
}

/// The stable built-in collection. Mild dry blends preserve consonants and
/// intelligibility; pitch/formant presets use separate controls deliberately.
pub fn builtin_presets() -> Vec<VoicePreset> {
    use EffectKind::*;
    use VoiceCategory::{Effects, Fun};
    vec![
        voice(
            "villager",
            "Villageois",
            "Un hmm grave et nasal, tout droit sorti du village.",
            "home",
            "#b8e986",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", -2.0)]),
                effect(FormantShift, &[("semitones", 2.5)]),
                effect(BandPass, &[("cutoffHz", 1000.0), ("q", 0.75)]),
                effect(Gain, &[("db", 3.0)]),
            ],
        ),
        voice(
            "robot",
            "Robot",
            "Une voix mécanique aux résonances métalliques.",
            "bot",
            "#72d6ff",
            Fun,
            vec![
                effect(HighPass, &[("cutoffHz", 100.0)]),
                effect(Robotize, &[("freqHz", 110.0)]),
                effect(Distortion, &[("drive", 2.0), ("mix", 0.18)]),
                effect(LowPass, &[("cutoffHz", 6500.0)]),
            ],
        ),
        voice(
            "demon",
            "Démon",
            "Une voix profonde, rauque et imposante.",
            "flame",
            "#ff7979",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", -7.0)]),
                effect(FormantShift, &[("semitones", -3.5)]),
                effect(Distortion, &[("drive", 3.5), ("mix", 0.28)]),
                effect(Reverb, &[("roomSize", 0.55), ("mix", 0.12)]),
            ],
        ),
        voice(
            "chipmunk",
            "Écureuil",
            "Une petite voix vive, aiguë et espiègle.",
            "rabbit",
            "#ffc978",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", 7.0)]),
                effect(FormantShift, &[("semitones", 3.0)]),
                effect(HighPass, &[("cutoffHz", 180.0)]),
            ],
        ),
        voice(
            "giant",
            "Géant",
            "Un timbre immense qui fait vibrer les montagnes.",
            "mountain",
            "#a9b8ff",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", -9.0)]),
                effect(FormantShift, &[("semitones", -4.0)]),
                effect(LowPass, &[("cutoffHz", 3000.0)]),
                effect(Reverb, &[("roomSize", 0.7), ("mix", 0.13)]),
            ],
        ),
        voice(
            "radio",
            "Radio",
            "Une émission vintage chaleureuse et légèrement saturée.",
            "radio",
            "#ffce8a",
            Effects,
            vec![
                effect(HighPass, &[("cutoffHz", 240.0)]),
                effect(LowPass, &[("cutoffHz", 3400.0)]),
                effect(
                    Compressor,
                    &[("thresholdDb", -22.0), ("ratio", 5.0), ("makeupDb", 5.0)],
                ),
                effect(Distortion, &[("drive", 2.2), ("mix", 0.22)]),
            ],
        ),
        voice(
            "telephone",
            "Téléphone",
            "La bande étroite familière d'un appel téléphonique.",
            "phone",
            "#7ee6c3",
            Effects,
            vec![
                effect(HighPass, &[("cutoffHz", 450.0), ("q", 0.8)]),
                effect(LowPass, &[("cutoffHz", 2600.0), ("q", 0.8)]),
                effect(
                    Compressor,
                    &[("thresholdDb", -24.0), ("ratio", 4.0), ("makeupDb", 5.0)],
                ),
            ],
        ),
        voice(
            "cathedral",
            "Cathédrale",
            "Une grande nef aux longues résonances enveloppantes.",
            "church",
            "#d6b5ff",
            Effects,
            vec![
                effect(
                    Reverb,
                    &[("roomSize", 0.96), ("damping", 0.3), ("mix", 0.48)],
                ),
                effect(
                    Echo,
                    &[("delayMs", 125.0), ("feedback", 0.22), ("mix", 0.1)],
                ),
            ],
        ),
        voice(
            "alien",
            "Extraterrestre",
            "Un visiteur spatial au timbre instable et curieux.",
            "alien",
            "#a0f08c",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", 3.0)]),
                effect(FormantShift, &[("semitones", 5.0)]),
                effect(RingMod, &[("freqHz", 43.0), ("mix", 0.3)]),
                effect(Chorus, &[("rateHz", 1.2), ("depthMs", 4.0), ("mix", 0.24)]),
            ],
        ),
        voice(
            "ghost",
            "Fantôme",
            "Une présence vaporeuse aux échos tremblants.",
            "ghost",
            "#cad1ff",
            Fun,
            vec![
                effect(Whisper, &[("amount", 0.55)]),
                effect(Vibrato, &[("rateHz", 3.0), ("depthSemitones", 0.3)]),
                effect(
                    Reverb,
                    &[("roomSize", 0.85), ("damping", 0.6), ("mix", 0.4)],
                ),
            ],
        ),
        voice(
            "gas-mask",
            "Masque à gaz",
            "Une voix étouffée derrière un respirateur.",
            "shield",
            "#b4d7a4",
            Fun,
            vec![
                effect(BandPass, &[("cutoffHz", 950.0), ("q", 0.6)]),
                effect(Distortion, &[("drive", 3.0), ("mix", 0.24)]),
                effect(Whisper, &[("amount", 0.22)]),
            ],
        ),
        voice(
            "male-to-female",
            "Voix féminine",
            "Un timbre plus clair et une hauteur légèrement relevée.",
            "sparkles",
            "#ffb0dd",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", 4.0)]),
                effect(FormantShift, &[("semitones", 2.0)]),
                effect(HighPass, &[("cutoffHz", 120.0)]),
            ],
        ),
        voice(
            "female-to-male",
            "Voix masculine",
            "Une voix plus basse avec des voyelles plus sombres.",
            "crown",
            "#91baff",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", -4.0)]),
                effect(FormantShift, &[("semitones", -2.0)]),
                effect(LowPass, &[("cutoffHz", 6000.0)]),
            ],
        ),
        voice(
            "megaphone",
            "Mégaphone",
            "Une annonce nasale, projetée et légèrement saturée.",
            "megaphone",
            "#ffe084",
            Effects,
            vec![
                effect(BandPass, &[("cutoffHz", 1700.0), ("q", 0.65)]),
                effect(Distortion, &[("drive", 5.0), ("mix", 0.55)]),
                effect(Gain, &[("db", 2.0)]),
            ],
        ),
        voice(
            "underwater",
            "Sous l'eau",
            "Des paroles assourdies qui ondulent sous la surface.",
            "bubbles",
            "#70d8ee",
            Effects,
            vec![
                effect(LowPass, &[("cutoffHz", 650.0), ("q", 0.9)]),
                effect(Vibrato, &[("rateHz", 2.2), ("depthSemitones", 0.5)]),
                effect(Chorus, &[("rateHz", 0.6), ("depthMs", 6.0), ("mix", 0.3)]),
            ],
        ),
        voice(
            "cave",
            "Grotte",
            "Des répétitions sombres sur les parois d'une caverne.",
            "cave",
            "#bba68c",
            Effects,
            vec![
                effect(
                    Echo,
                    &[("delayMs", 175.0), ("feedback", 0.48), ("mix", 0.35)],
                ),
                effect(
                    Reverb,
                    &[("roomSize", 0.78), ("damping", 0.8), ("mix", 0.28)],
                ),
                effect(LowPass, &[("cutoffHz", 4200.0)]),
            ],
        ),
        voice(
            "baby",
            "Bébé",
            "Une toute petite voix ronde et joyeuse.",
            "baby",
            "#ffb8b8",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", 9.0)]),
                effect(FormantShift, &[("semitones", 2.5)]),
                effect(LowPass, &[("cutoffHz", 5000.0)]),
            ],
        ),
        voice(
            "old-man",
            "Vieillard",
            "Un timbre usé avec un léger tremblement.",
            "hourglass",
            "#dfc591",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", -1.5)]),
                effect(FormantShift, &[("semitones", -1.5)]),
                effect(Vibrato, &[("rateHz", 5.2), ("depthSemitones", 0.22)]),
                effect(Distortion, &[("drive", 1.8), ("mix", 0.12)]),
            ],
        ),
        voice(
            "zombie",
            "Zombie",
            "Une plainte lente, grave et granuleuse.",
            "skull",
            "#b0d594",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", -5.0)]),
                effect(FormantShift, &[("semitones", -3.0)]),
                effect(Bitcrush, &[("bits", 10.0), ("downsample", 2.0)]),
                effect(Distortion, &[("drive", 3.0), ("mix", 0.25)]),
                effect(LowPass, &[("cutoffHz", 2600.0)]),
            ],
        ),
        voice(
            "crystal",
            "Cristal",
            "Une voix lumineuse aux reflets délicatement doublés.",
            "snowflake",
            "#a2efff",
            Fun,
            vec![
                effect(PitchShift, &[("semitones", 5.0)]),
                effect(Chorus, &[("rateHz", 0.7), ("depthMs", 2.0), ("mix", 0.3)]),
                effect(
                    Reverb,
                    &[("roomSize", 0.65), ("damping", 0.25), ("mix", 0.22)],
                ),
            ],
        ),
        voice(
            "retro-8bit",
            "Rétro 8 bits",
            "Un personnage pixelisé tout droit sorti d'une console.",
            "tv",
            "#f2a4fa",
            Fun,
            vec![
                effect(Bitcrush, &[("bits", 5.0), ("downsample", 6.0)]),
                effect(Robotize, &[("freqHz", 165.0)]),
                effect(LowPass, &[("cutoffHz", 6500.0)]),
            ],
        ),
        voice(
            "whisper",
            "Chuchotement",
            "Un souffle doux qui conserve l'articulation des mots.",
            "wave",
            "#afc4ef",
            Effects,
            vec![
                effect(Whisper, &[("amount", 0.96)]),
                effect(HighPass, &[("cutoffHz", 160.0)]),
                effect(
                    Compressor,
                    &[("thresholdDb", -28.0), ("ratio", 3.0), ("makeupDb", 6.0)],
                ),
            ],
        ),
    ]
}
