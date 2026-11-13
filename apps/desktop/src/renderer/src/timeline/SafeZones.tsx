/**
 * Where YouTube's Shorts player covers the picture (approximate; ADR-034): the top bar, the
 * buttons down the right, and the title, channel and music line at the bottom. Keep faces and
 * captions out of the shaded parts.
 */
export function SafeZones() {
  return (
    <div className="safe-zones" data-testid="safe-zones" aria-hidden="true">
      <div className="safe-zones__band" style={{ left: 0, right: 0, top: 0, height: '8%' }} />
      <div className="safe-zones__band" style={{ left: 0, right: 0, bottom: 0, height: '20%' }}>
        <span>Title, channel and music</span>
      </div>
      <div
        className="safe-zones__band"
        style={{ right: 0, width: '15%', top: '42%', bottom: '20%' }}
      >
        <span>Buttons</span>
      </div>
      <div
        className="safe-zones__frame"
        style={{ left: '4%', right: '15%', top: '8%', bottom: '20%' }}
      />
    </div>
  );
}
