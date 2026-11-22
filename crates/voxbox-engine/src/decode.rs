use crate::{DecodedSound, EngineError, Result};
use rubato::{FastFixedIn, PolynomialDegree, Resampler};
use std::{fs::File, path::Path, sync::Arc};
use symphonia::core::{
    audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions,
    io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};

fn error(error: impl std::fmt::Display) -> EngineError {
    EngineError::Decode(error.to_string())
}
fn too_long() -> EngineError {
    error("Le fichier audio dépasse la durée maximale de 10 minutes.")
}

pub(crate) fn decode(path: &Path) -> Result<DecodedSound> {
    let file = File::open(path).map_err(error)?;
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(extension);
    }
    let source = MediaSourceStream::new(Box::new(file), Default::default());
    let probe = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(error)?;
    let mut format = probe.format;
    let track = format
        .default_track()
        .ok_or_else(|| error("Aucune piste audio."))?;
    let id = track.id;
    let params = track.codec_params.clone();
    if let (Some(frames), Some(rate)) = (params.n_frames, params.sample_rate) {
        if frames > u64::from(rate) * 600 {
            return Err(too_long());
        }
    }
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(error)?;
    let mut mono = Vec::new();
    let mut sample_rate = None;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(error(e)),
        };
        if packet.track_id() != id {
            continue;
        }
        let decoded = decoder.decode(&packet).map_err(error)?;
        let spec = *decoded.spec();
        if spec.rate == 0 || spec.channels.count() == 0 {
            return Err(error("Format audio invalide."));
        }
        if sample_rate.is_some_and(|rate| rate != spec.rate) {
            return Err(error("La fréquence audio change dans le fichier."));
        }
        sample_rate = Some(spec.rate);
        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        for frame in samples.samples().chunks_exact(spec.channels.count()) {
            if mono.len() >= spec.rate as usize * 600 {
                return Err(too_long());
            }
            let sample = super::device::downmix(frame);
            mono.push(if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            });
        }
    }
    let rate = sample_rate.ok_or_else(|| error("La piste audio est vide."))?;
    let samples = resample(&mono, rate)?;
    let duration_ms = (samples.len() / 48) as u32;
    Ok(DecodedSound {
        samples: Arc::from(samples),
        duration_ms,
    })
}

pub(crate) fn resample(input: &[f32], rate: u32) -> Result<Vec<f32>> {
    if rate == 48_000 {
        return Ok(input.to_vec());
    }
    if rate == 0 {
        return Err(error("Fréquence audio invalide."));
    }
    const CHUNK: usize = 1024;
    let mut resampler = FastFixedIn::<f32>::new(
        48_000.0 / rate as f64,
        1.0,
        PolynomialDegree::Cubic,
        CHUNK,
        1,
    )
    .map_err(error)?;
    let delay = resampler.output_delay();
    let expected = (input.len() as u64 * 48_000 / u64::from(rate)) as usize;
    let mut result = Vec::with_capacity(expected + CHUNK * 2);
    let mut source = [0.0; CHUNK];
    let mut target = resampler.output_buffer_allocate(true);
    let mut position = 0;
    while result.len() < expected + delay {
        source.fill(0.0);
        let available = (input.len() - position).min(CHUNK);
        source[..available].copy_from_slice(&input[position..position + available]);
        position += available;
        let (_, written) = resampler
            .process_into_buffer(&[&source[..]], &mut target, None)
            .map_err(error)?;
        result.extend_from_slice(&target[0][..written]);
    }
    Ok(result[delay..delay + expected].to_vec())
}
