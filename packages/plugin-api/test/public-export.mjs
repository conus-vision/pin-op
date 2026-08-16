import assert from "node:assert/strict";
import { SOURCE_PLUGIN_API_VERSION } from "../dist/index.js";

assert.equal(SOURCE_PLUGIN_API_VERSION, 2);
