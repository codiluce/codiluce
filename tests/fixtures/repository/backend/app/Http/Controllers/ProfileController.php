<?php
namespace App\Http\Controllers;
use App\Http\Requests\UpdateProfileRequest;
use App\Models\User;
use App\Services\AuthService;
use Illuminate\Support\Facades\DB;
class ProfileController extends Controller {
    public function __construct(private AuthService $auth) {}
    public function show(int $id) {
        if ($id < 1) {
            abort(404);
        }
        $user = $this->auth->authenticate('demo@example.com');
        return response()->json($user, 200);
    }
    public function update(UpdateProfileRequest $request, int $id) {
        $user = User::findOrFail($id);
        $user->update($request->validated());
        DB::table('audit')->insert(['user' => $id]);
        $this->audit($id);
        return redirect()->back();
    }
    private function audit(int $id): void {
        $this->unknownHelper->record($id);
    }
}
