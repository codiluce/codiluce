<?php
namespace PackageAnonymous;
function target(): int { return 1; }
function outer(): void {
    register(function (int $value) use ($captured): int { return target(); });
    register(fn (int $left) => fn (int $right) => target());
}
