// The clip finder (ported from Clipalytics, ADR-046): local signals → ranked moments → optional
// AI scoring. Pure TypeScript: the backend measures the media with FFmpeg and passes numbers in.
export * from './types';
export * from './series';
export * from './transcript';
export * from './signals';
export * from './moments';
export * from './analyze';
export * from './scoring';
