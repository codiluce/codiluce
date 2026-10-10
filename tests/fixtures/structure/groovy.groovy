// Original Groovy source only; no compiler, JVM or DSL execution.
package structure
import static java.util.Collections.emptyList as empty
trait StructureGroovy {
  String label
  private int count=0
  def read(int offset=1) {count+offset}
}
record StructureGroovyPair(String left, int right) {}
def groovyHelper(String value) {value}
