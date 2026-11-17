// The screen module is emitted by emcc (src/screen/build.sh) and has no types.
// Declaring it here rather than adding `any` at the import site keeps the one
// untyped boundary in one visible place.
declare module "*/build/screen.mjs" {
  const factory: (overrides?: Record<string, unknown>) => Promise<any>;
  export default factory;
}
