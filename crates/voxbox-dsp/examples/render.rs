//! Offline audition: cargo run -p voxbox-dsp --release --example render -- villager in.wav out.wav
//! WAV input must be 48 kHz. Multiple channels are averaged to mono. Output is
//! 32-bit float mono, with two seconds of tail; the initial processing delay is preserved.
use std::{error::Error, io};

use voxbox_dsp::{builtin_presets, VoiceChain, BLOCK_SIZE, SAMPLE_RATE};

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err(
            invalid("Usage : render <preset-id> <in.wav> <out.wav> (entrée à 48 kHz)").into(),
        );
    }
    let presets = builtin_presets();
    let preset = presets.iter().find(|p| p.id == args[1]).ok_or_else(|| {
        invalid(format!(
            "Voix inconnue. Identifiants : {}",
            presets
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;
    if std::path::Path::new(&args[2]) == std::path::Path::new(&args[3]) {
        return Err(invalid("Les fichiers d'entrée et de sortie doivent être différents.").into());
    }
    let mut reader = hound::WavReader::open(&args[2])?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE || spec.channels == 0 {
        return Err(invalid("Le WAV doit être à 48 000 Hz, avec au moins un canal.").into());
    }
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 2.0_f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|s| s as f32 / scale))
                .collect::<Result<_, _>>()?
        }
    };
    let channels = usize::from(spec.channels);
    if !interleaved.len().is_multiple_of(channels) {
        return Err(invalid("Le WAV contient une trame incomplète.").into());
    }
    let mut audio: Vec<f32> = interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    let mut chain = VoiceChain::new(&preset.effects);
    let latency = chain.latency_samples();
    audio.resize(audio.len() + 2 * SAMPLE_RATE as usize + latency, 0.0);
    for block in audio.chunks_mut(BLOCK_SIZE) {
        chain.process(block);
    }
    let mut writer = hound::WavWriter::create(
        &args[3],
        hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )?;
    for sample in &audio {
        writer.write_sample(*sample)?;
    }
    writer.finalize()?;
    println!(
        "{} → {} ({}, retard annoncé : {} échantillons)",
        args[2], args[3], preset.name, latency
    );
    Ok(())
}
