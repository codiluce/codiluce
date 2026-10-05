<?php
namespace App\Console\Commands;
use App\Models\User;
use Illuminate\Console\Command;
class SendReports extends Command {
    protected $signature = 'reports:send
        {--daily : Only the daily report}';
    protected $description = 'Send the activity reports';
    public function handle(): int {
        $users = User::where('active', true)->get();
        $this->call('reports:prune');
        return 0;
    }
}
