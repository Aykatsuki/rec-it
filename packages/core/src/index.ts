// Pure domain logic: no Electron, React or Node-specific imports (ADR-002).
// Phase 0 provides time maths and ids; the full data model arrives in Phase 2.
export * from './time';
export * from './ids';
