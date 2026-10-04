<?php
namespace App\Services;
use App\Models\Profile;
use App\Models\User;
class AuthService {
    public function authenticate(string $email) { return User::where('email', $email)->first(); }
    public function profileOf(int $userId) { return Profile::where('user_id', $userId)->first(); }
}
