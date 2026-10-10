// 😀 original C++ source
namespace StructureCpp {
class Item {
public:
    Item();
    ~Item();
    int get(int value) const;
    int (*callback)(int);
};
int Item::get(int value) const { return value; }
template<class T> class Box { public: T get(T value) { return value; } };
}
