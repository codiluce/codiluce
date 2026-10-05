<?php
use App\Console\Commands\PruneReports;
use App\Jobs\RebuildIndex;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;
Artisan::command('inspire', function () {
    $this->comment('Stay curious');
})->purpose('Display an inspiring quote');
Schedule::command('reports:send --daily')->dailyAt('02:00')->withoutOverlapping();
Schedule::command(PruneReports::class)->weekly();
Schedule::job(new RebuildIndex)->everyThreeHours();
Schedule::command('reports:missing')->hourly();
