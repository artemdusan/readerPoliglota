export function UiIcon({ name, className = "", title, strokeWidth = 1.8 }) {
  const props = {
    className: `ui-icon ${className}`.trim(),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": title ? undefined : "true",
    role: title ? "img" : undefined,
  };

  switch (name) {
    case "search":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
      );
    case "bookmark":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="M7 4.75h10v14.5l-5-3.25-5 3.25z" />
        </svg>
      );
    case "play":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="m9 7 8 5-8 5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "pause":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="M9 7.5v9" />
          <path d="M15 7.5v9" />
        </svg>
      );
    case "type":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="M5 6.5h14" />
          <path d="M12 6.5v11" />
          <path d="M9 17.5h6" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="m12 3 1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4z" />
          <path d="m18.5 13.5.8 2 .2.5.5.2 2 .8-2 .8-.5.2-.2.5-.8 2-.8-2-.2-.5-.5-.2-2-.8 2-.8.5-.2.2-.5z" />
          <path d="m5.5 14.5.9 2.2.2.5.5.2 2.2.9-2.2.9-.5.2-.2.5-.9 2.2-.9-2.2-.2-.5-.5-.2-2.2-.9 2.2-.9.5-.2.2-.5z" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="M20 6v5h-5" />
          <path d="M4 18v-5h5" />
          <path d="M6.8 9A7 7 0 0 1 18.4 6L20 7.5" />
          <path d="M17.2 15A7 7 0 0 1 5.6 18L4 16.5" />
        </svg>
      );
    case "pointer":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="m7 4 8 8-4 1.3 2.3 5.7-2.4 1-2.3-5.7L5 18z" />
        </svg>
      );
    case "voice":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <rect x="9" y="4.5" width="6" height="10" rx="3" />
          <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" />
          <path d="M12 17v3.5" />
          <path d="M9 20.5h6" />
        </svg>
      );
    case "translate":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="M4 6.5h9" />
          <path d="M8.5 6.5c0 5-2.3 8.5-5.5 10.5" />
          <path d="M5.5 12.5c1.7 1.5 3.4 2.7 5.5 3.5" />
          <path d="M14.5 9.5h6" />
          <path d="m17.5 8-4 10" />
          <path d="M15 14.5h5" />
        </svg>
      );
    case "menu":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      );
    case "settings":
      return (
        <svg {...props}>
          {title ? <title>{title}</title> : null}
          <circle cx="12" cy="12" r="2.75" />
          <path d="m12 3.75 1 2.05 2.25.34.67 2.18 1.97 1.18-.52 2.22.52 2.22-1.97 1.18-.67 2.18-2.25.34-1 2.05-2.05-1-2.25-.34-.67-2.18-1.97-1.18.52-2.22-.52-2.22 1.97-1.18.67-2.18 2.25-.34z" />
        </svg>
      );
    default:
      return null;
  }
}
