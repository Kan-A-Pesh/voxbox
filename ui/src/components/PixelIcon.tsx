import { memo } from "react";
import { ICONS, isIconName, type IconName } from "./icons";

interface Props {
  name: IconName | string;
  /** Integer pixel scale: 1 px of bitmap = `scale` CSS px. */
  scale?: number;
  color?: string;
  className?: string;
  title?: string;
}

/** Crisp 12×12 bitmap icon. Horizontal runs are merged into single rects. */
export const PixelIcon = memo(function PixelIcon({ name, scale = 2, color = "currentColor", className, title }: Props) {
  const rows = ICONS[isIconName(name) ? name : "wrench"];
  const rects: React.ReactElement[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let end = x;
      while (row[end] === "#") end++;
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} />);
      x = end;
    }
  });
  const size = 12 * Math.max(1, Math.round(scale));
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      fill={color}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {rects}
    </svg>
  );
});
