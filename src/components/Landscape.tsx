export function Landscape({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1100 620"
      fill="none"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="sky" x1="600" y1="0" x2="600" y2="620" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1e302f" />
          <stop offset=".65" stopColor="#49615a" />
          <stop offset="1" stopColor="#ac8262" />
        </linearGradient>
        <linearGradient id="sun" x1="800" y1="80" x2="800" y2="320" gradientUnits="userSpaceOnUse">
          <stop stopColor="#efd3a5" />
          <stop offset="1" stopColor="#dd936c" />
        </linearGradient>
        <linearGradient id="lake" x1="0" y1="420" x2="0" y2="620" gradientUnits="userSpaceOnUse">
          <stop stopColor="#78917c" />
          <stop offset="1" stopColor="#243c36" />
        </linearGradient>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope=".09" />
          </feComponentTransfer>
          <feBlend in="SourceGraphic" mode="soft-light" />
        </filter>
      </defs>
      <g filter="url(#grain)">
        <path fill="url(#sky)" d="M0 0h1100v620H0z" />
        <circle cx="817" cy="179" r="103" fill="url(#sun)" />
        <path
          d="m0 348 171-132 110 90 133-157 107 113 92-76 112 128 121-65 154 107 100-36v200H0Z"
          fill="#4b655d"
        />
        <path d="m125 365 192-74 146 42 181-162 170 170 172-92 114 108v183H0Z" fill="#324e46" />
        <path d="m550 272 94-101 82 83-64-24-21 21-26-19Z" fill="#8e9b82" opacity=".6" />
        <path d="m0 386 200-43 222 70 201-61 233 56 244-54v266H0Z" fill="#1c3933" />
        <path d="M0 422c247-25 361 39 567 8 211-33 351-28 533 1v189H0Z" fill="url(#lake)" />
        <g stroke="#b1b398" opacity=".34">
          <path d="M560 454h263m-183 20h291m-449 22h184m81 23h269m-366 29h192m-92 23h260" />
          <path d="M35 453h165m80 42h110m-260 47h135m35 40h254" />
        </g>
        <path d="M0 525c141-20 201-3 300 29s124 39 216 66H0Z" fill="#132a27" />
        <path d="M1100 473c-120-2-175 43-225 65-69 31-98 42-156 82h381Z" fill="#122823" />
        <g fill="#101e1c">
          <path d="m986 92-5 415h20L993 92Z" />
          <path d="m991 82-52 115 30-9-48 88 41-14-60 95 65-16-72 104 110-30 95 20-67-101 49 16-53-83 38 7-44-79 24 7Z" />
          <path d="m1071 195-5 304h14l-4-304Z" />
          <path d="m1074 183-40 84 22-5-37 67 30-7-47 78 43-10-54 89 109-16V258Z" />
        </g>
        <g fill="#172722">
          <path d="M757 381h9v148h-9zm81 0h9v130h-9z" />
          <path d="m734 369 133-7-9 17-115 6Z" />
          <path d="m744 396 114-6-2 10-110 6Z" />
          <path d="m757 376-14 136h9l15-136zm81-5 13 138h9l-13-138Z" />
        </g>
        <g stroke="#1d342e" strokeWidth="2">
          <path d="m625 97 8-3 9 4m12-7 7-3 8 3m-113 46 6-3 8 3" />
        </g>
        <g fill="#d9c09c" opacity=".6">
          <circle cx="720" cy="46" r="1.3" />
          <circle cx="887" cy="52" r="1" />
          <circle cx="536" cy="68" r="1" />
          <circle cx="972" cy="49" r="1.4" />
          <circle cx="454" cy="101" r="1.2" />
        </g>
      </g>
    </svg>
  );
}
