import "@testing-library/jest-dom";
import { vi } from "vitest";

if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = vi.fn(() => "blob:test");
}

// Radix's Select and Popover drive their open state through the Pointer Events
// API and scroll the highlighted item into view. jsdom implements neither, so
// without these a test that opens a Select throws rather than failing on what
// it meant to assert.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
