<?php
namespace App\Http\Controllers;
use App\Jobs\RebuildIndex;
use App\Models\User;
use Illuminate\Support\Facades\Artisan;
use Inertia\Inertia;
class AdminController extends Controller {
    public function index() {
        $users = User::all();
        return Inertia::render('admin/dashboard', ['users' => $users]);
    }
    public function rebuild() {
        Artisan::call('reports:send', ['--daily' => true]);
        dispatch(new RebuildIndex());
        return back();
    }
    public function missing() {
        return Inertia::render('admin/missing');
    }
}
