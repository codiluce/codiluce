// Original Scala 2/3 syntax only; no compiler, JVM or target execution.
package structure
import scala.math.Ordered
class StructureScala(val value:Int) {
  def read(offset:Int):Int = value + offset
}
object StructureScala {
  given default:Int = 1
}
extension (value:StructureScala) {
  def describe(prefix:String):String = prefix
}
enum StructureScalaState {case Ready; case Failed(code:Int)}
