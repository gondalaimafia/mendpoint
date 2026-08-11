import React from "react";

type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className = "brand-mark" }: BrandMarkProps) {
  return (
    <svg
      aria-label="Mendpoint arrow mark"
      className={className}
      role="img"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="mendpoint-arrow-gradient" x1="4" x2="44" y1="8" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#356cff" />
          <stop offset="1" stopColor="#00bcc1" />
        </linearGradient>
      </defs>
      <path
        d="M4 7h12l13.5 13.5H35V13l10.5 11L35 35v-7.5h-8.5L12 12H4V7Zm0 13h18l4 4-4 4H4l4-4-4-4Zm0 21h12l13.5-13.5H35V35l10.5-11L35 13v7.5h-8.5L12 36H4v5Z"
        fill="url(#mendpoint-arrow-gradient)"
        fillRule="evenodd"
      />
    </svg>
  );
}
