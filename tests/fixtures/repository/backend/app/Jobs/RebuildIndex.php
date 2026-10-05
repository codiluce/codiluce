<?php
namespace App\Jobs;
use App\Models\User;
class RebuildIndex {
    public static function dispatch(): void {}
    public function handle(): void {
        User::query()->update(['indexed' => true]);
    }
}
