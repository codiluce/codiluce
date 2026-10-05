<?php
namespace App\Console\Commands;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
class PruneReports extends Command {
    protected $signature = 'reports:prune';
    public function handle(): void {
        DB::table('audit')->delete();
    }
}
