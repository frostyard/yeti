import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field, TextInput } from "./FormField";

describe("Field env-override awareness", () => {
  it("shows the env-var note when envVar is set", () => {
    render(<Field label="Auth token" envVar="YETI_AUTH_TOKEN"><TextInput /></Field>);
    expect(screen.getByText(/Set via env var YETI_AUTH_TOKEN/)).toBeInTheDocument();
  });

  it("shows the plain hint (not an env note) when not overridden", () => {
    render(<Field label="Auth token" hint="A token is currently set."><TextInput /></Field>);
    expect(screen.getByText("A token is currently set.")).toBeInTheDocument();
    expect(screen.queryByText(/Set via env var/)).not.toBeInTheDocument();
  });
});
