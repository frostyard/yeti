import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill, Badge, StatCard } from "./status";

describe("StatusPill", () => {
  it("renders label text with an accessible label", () => {
    render(<StatusPill kind="running" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
  });

  it("honors a custom label (color is not the only signal)", () => {
    render(<StatusPill kind="failed" label="Broke" />);
    expect(screen.getByText("Broke")).toBeInTheDocument();
  });
});

describe("Badge + StatCard", () => {
  it("Badge renders children", () => {
    render(<Badge color="#4aa8ff">Refined</Badge>);
    expect(screen.getByText("Refined")).toBeInTheDocument();
  });

  it("StatCard shows label and value", () => {
    render(<StatCard label="Running" value={3} tone="accent" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
