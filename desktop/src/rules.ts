// The client's decision logic, kept out of main.ts so it can be exercised
// without a window. Everything here decides something; nothing here draws.
//
// One drawer per domain (#281). This facade re-exports the lot so no import
// site changed on the day of the split; new code may reach for the drawer.

export * from "./rules/addressing";
export * from "./rules/definitions";
export * from "./rules/sessions";
export * from "./rules/turn";
export * from "./rules/room";
export * from "./rules/mirror";
export * from "./rules/notices";
