<?php
namespace PackageBinding;
interface Contract { public function read(): int; }
trait Shared { public function shared(): int { return 1; } }
class Virtual { public function read(): int { return 1; } }
final class Worker implements Contract {
    use Shared;
    public function __construct(public int $id = 1) {}
    public function read(): int { return phpBindingHelper(); }
}
function phpBindingHelper(): int { return 1; }
function phpBindingEntry(Virtual $nominal): void {
    $closure = function (): int { return phpBindingHelper(); };
    $closure();
    $callback = phpBindingHelper(...);
    $callback();
    $nominal->read();
    $service = new Worker();
    $service->read();
    $service->shared();
    $unknown();
}
