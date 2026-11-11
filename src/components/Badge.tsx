import React from "react";

interface BadgeProps {
  variant?: "success" | "warning" | "danger" | "info" | "neutral" | "purple";
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant = "neutral", children, className = "" }: BadgeProps) {
  const variantStyles = {
    success:
      "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    warning:
      "bg-amber-500/10 text-amber-400 border-amber-500/20",
    danger:
      "bg-rose-500/10 text-rose-400 border-rose-500/20",
    info:
      "bg-sky-500/10 text-sky-400 border-sky-500/20",
    purple:
      "bg-purple-500/10 text-purple-400 border-purple-500/20",
    neutral:
      "bg-slate-800 text-slate-300 border-slate-700",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${variantStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

