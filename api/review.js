import { handle } from "../lib/core.js";
export const config = { maxDuration: 120 };
export function POST(request) { return handle(request, "review"); }
