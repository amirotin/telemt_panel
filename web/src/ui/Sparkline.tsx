export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}

// Sparkline — pure SVG line, no charting library (StatCard's optional
// slot, fed from GET /api/history in later tasks). Renders nothing
// meaningful for 0-1 points rather than dividing by zero.
export function Sparkline({ values, width = 96, height = 28, className }: SparklineProps) {
  if (values.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden="true" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label="Динамика значения"
    >
      <polyline
        points={points}
        fill="none"
        stroke="rgb(var(--accent))"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
