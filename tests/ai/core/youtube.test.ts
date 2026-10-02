import { describe, expect, it } from 'vitest';
import { vttLines, vttToTranscript } from '../../../src/ai/core/vtt';
import { pickSubtitle, youtubeVideoUrl } from '../../../src/ai/core/youtube';

describe('youtubeVideoUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=UF8uR6Z6KLc', 'UF8uR6Z6KLc'],
    ['https://youtube.com/watch?v=UF8uR6Z6KLc&t=42s', 'UF8uR6Z6KLc'],
    // Opened inside a playlist: only the video is taken (yt-dlp also gets --no-playlist).
    ['https://www.youtube.com/watch?v=UF8uR6Z6KLc&list=PL0123456789', 'UF8uR6Z6KLc'],
    ['https://m.youtube.com/watch?v=UF8uR6Z6KLc', 'UF8uR6Z6KLc'],
    ['https://youtu.be/UF8uR6Z6KLc?si=abc', 'UF8uR6Z6KLc'],
    ['https://www.youtube.com/shorts/M-cd7Q-Onhk', 'M-cd7Q-Onhk'],
  ])('reads %s', (url, id) => {
    expect(youtubeVideoUrl(url)).toBe(`https://www.youtube.com/watch?v=${id}`);
  });

  it.each([
    'https://www.youtube.com/playlist?list=PL0123456789',
    'https://www.youtube.com/watch?v=short',
    'https://example.com/watch?v=UF8uR6Z6KLc',
    'file:///watch?v=UF8uR6Z6KLc',
    'not a url',
  ])('refuses %s', url => {
    expect(youtubeVideoUrl(url)).toBeNull();
  });
});

describe('pickSubtitle', () => {
  // The shapes yt-dlp reported for real videos (artifacts/lev-270 runs/y-dump-*.json), cut to the keys.
  const jobs = {
    language: 'en',
    subtitles: { ar: [], 'en-eEY6OEpapPo': [], 'es-ES': [], it: [], ja: [], 'pt-BR': [] },
    automatic_captions: { en: [], 'en-orig': [], ja: [], fr: [] },
  };
  const japanese = { language: 'ja', subtitles: {}, automatic_captions: { en: [], ja: [], 'ja-orig': [] } };

  it('takes the uploaded track in the video language, matching a suffixed key by its language', () => {
    expect(pickSubtitle(jobs, 'ja')).toEqual({ language: 'en-eEY6OEpapPo', automatic: false });
  });

  it('then the uploaded track in the UI language', () => {
    expect(pickSubtitle({ ...jobs, subtitles: { ar: [], ja: [] } }, 'ja')).toEqual({ language: 'ja', automatic: false });
  });

  it('then any uploaded track', () => {
    expect(pickSubtitle({ ...jobs, subtitles: { ar: [] } }, 'ja')).toEqual({ language: 'ar', automatic: false });
  });

  it("then the automatic captions in the video's own language, -orig first", () => {
    expect(pickSubtitle(japanese, 'en')).toEqual({ language: 'ja-orig', automatic: true });
    expect(pickSubtitle({ language: 'ja', automatic_captions: { ja: [], en: [] } }, 'en')).toEqual({ language: 'ja', automatic: true });
  });

  it('never takes a machine translation (another language among the automatic captions)', () => {
    expect(pickSubtitle({ language: 'en', subtitles: {}, automatic_captions: { ja: [], fr: [] } }, 'ja')).toBeNull();
  });

  it('finds the automatic captions of a language given with a region (en-US, artifacts/lev-270 114i2Kz-LZA)', () => {
    const lecture = { language: 'en-US', subtitles: {}, automatic_captions: { 'ar-orig': [], en: [], 'en-orig': [], 'ja-orig': [], ja: [] } };
    expect(pickSubtitle(lecture, 'ja')).toEqual({ language: 'en-orig', automatic: true });
    expect(pickSubtitle({ ...lecture, automatic_captions: { en: [], ja: [] } }, 'ja')).toEqual({ language: 'en', automatic: true });
    // The uploaded track of that video is matched by its language too.
    expect(pickSubtitle({ ...lecture, subtitles: { 'en-j3PyPqV-e1s': [] } }, 'ja')).toEqual({ language: 'en-j3PyPqV-e1s', automatic: false });
  });

  it('without the video language, takes an -orig track only when it is the only one', () => {
    expect(pickSubtitle({ language: null, automatic_captions: { ja: [], 'en-orig': [] } }, 'ja')).toEqual({ language: 'en-orig', automatic: true });
    expect(pickSubtitle({ language: null, automatic_captions: { ja: [], en: [] } }, 'ja')).toBeNull();
    expect(pickSubtitle({ language: null, automatic_captions: { 'ar-orig': [], 'en-orig': [] } }, 'ja')).toBeNull();
  });

  it('ignores a stream chat replay and reports nothing when nothing is left', () => {
    expect(pickSubtitle({ language: 'en', subtitles: { live_chat: [] }, automatic_captions: {} }, 'ja')).toBeNull();
    expect(pickSubtitle({}, 'ja')).toBeNull();
  });
});

describe('vttToTranscript', () => {
  // YouTube's automatic captions: each cue shows the line before and the new one word by word, then a 10 ms cue
  // shows it plain. The stage-0 rule (artifacts/lev-268 vtt2txt.py) keeps each line once.
  const rolling = [
    'WEBVTT', 'Kind: captions', 'Language: en', '',
    '00:00:00.000 --> 00:00:02.000 align:start position:0%', ' ', 'I am honored<00:00:00.500><c> to</c><00:00:01.000><c> be</c>', '',
    '00:00:02.000 --> 00:00:02.010 align:start position:0%', 'I am honored to be', ' ', '',
    '00:00:02.010 --> 00:00:05.000 align:start position:0%', 'I am honored to be', 'with you today<00:00:03.000><c> for</c>', '',
    '00:00:05.000 --> 00:00:05.010 align:start position:0%', 'with you today for', ' ', '',
    '00:00:31.000 --> 00:00:33.000 align:start position:0%', 'with you today for', 'your commencement &amp; more', '',
    '01:02:03.000 --> 01:02:05.000', 'the end', '',
  ].join('\n');

  it('keeps each line once, without tags or entities', () => {
    expect(vttLines(rolling).map(line => line.text)).toEqual([
      'I am honored to be', 'with you today for', 'your commencement & more', 'the end',
    ]);
  });

  it('folds lines into [mm:ss] paragraphs of 30 seconds, minutes past an hour included', () => {
    expect(vttToTranscript(rolling)).toBe([
      '[00:00] I am honored to be with you today for',
      '[00:31] your commencement & more',
      '[62:03] the end',
    ].join('\n'));
  });

  it('reads uploaded subtitles (several lines a cue, a byte order mark, a NOTE block, MM:SS cues)', () => {
    const uploaded = '﻿WEBVTT\n\nNOTE written by hand\nnot a line\n\n00:01.000 --> 00:04.000\nStay hungry.\nStay foolish.\n\n00:40.000 --> 00:42.000\nThank you.\n';
    expect(vttToTranscript(uploaded)).toBe('[00:01] Stay hungry. Stay foolish.\n[00:40] Thank you.');
  });

  it('is empty for a file without cues', () => {
    expect(vttToTranscript('WEBVTT\n\n')).toBe('');
  });
});
