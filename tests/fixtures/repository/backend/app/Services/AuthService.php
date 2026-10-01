<?php
namespace App\Services;
use App\Models\User;
class AuthService {
    public function authenticate(string $email) { return User::where('email', $email)->first(); }
}
