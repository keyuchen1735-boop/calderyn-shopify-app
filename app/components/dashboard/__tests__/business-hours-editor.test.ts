import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { BusinessHoursEditor } from "../BusinessHoursEditor";

const base = {
  start: "09:00",
  end: "17:00",
  tz: "America/New_York",
  onToggle: () => {},
  onChangeWindow: () => {},
};

describe("BusinessHoursEditor render", () => {
  it("hides the window selects when disabled (off)", () => {
    const html = renderToString(h(BusinessHoursEditor, { ...base, enabled: false }));
    expect(html).toContain("Only act during business hours");
    expect(html).not.toContain("<select");
  });
  it("shows the start/end selects and the timezone when on", () => {
    const html = renderToString(h(BusinessHoursEditor, { ...base, enabled: true }));
    expect(html).toContain("<select");
    expect(html).toContain("America/New_York");
    // selected hours reflect the props
    expect(html).toContain('value="09:00" selected');
    expect(html).toContain('value="17:00" selected');
  });
});
