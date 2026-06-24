"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  {
    label: "GET STARTED",
    items: [
      { href: "/docs/overview",   title: "Overview"   },
      { href: "/docs/quickstart", title: "Quickstart" },
    ],
  },
];

export function DocNav() {
  const pathname = usePathname();
  return (
    <nav className="docs-sidebar-nav">
      {NAV.map((section) => (
        <div key={section.label} className="docs-nav-section">
          <span className="docs-nav-label">{section.label}</span>
          {section.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`docs-nav-link${pathname === item.href ? " active" : ""}`}
            >
              {item.title}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
