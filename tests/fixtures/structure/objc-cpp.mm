// Original macro and mixed-language source, with no SDK/compiler execution.
typedef NS_OPTIONS(unsigned, StructureObjcMask) { StructureMaskRead=1, StructureMaskWrite=2 };
namespace packaged_native {
class StructureBridgeCpp { public: int read() const { return 1; } };
}
@interface StructureCppBridge
+(id)from:(const std::string&)text;
-(std::string)native;
@end
@implementation StructureCppBridge
+(id)from:(const std::string&)text { return nil; }
-(std::string)native { return std::string(); }
@end
