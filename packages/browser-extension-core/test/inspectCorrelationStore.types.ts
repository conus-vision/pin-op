import { InspectCorrelationStore } from "../src/inspectCorrelationStore.js";

const store = new InspectCorrelationStore();

store.record("panel-a", "inspect-a", 7, 10);

// @ts-expect-error Source authority must always bind to an exact browser window.
store.record("panel-a", "inspect-a", 7);
