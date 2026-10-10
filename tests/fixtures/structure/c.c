// 😀 original C source
struct StructureC { int value; int (*callback)(int); };
int StructureCFunction(int value);
int StructureCFunction(int value) { return value; }
#if SOURCE_BRANCH
int StructureCConditional(void) { return 1; }
#else
int StructureCConditional(void) { return 2; }
#endif
#define StructureCMacro(name) int name(void) { return 0; }
