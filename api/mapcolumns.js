import { handle } from "../lib/core.js";
export const config = { maxDuration: 60 };
export function POST(request) { return handle(request, "mapcolumns"); }
