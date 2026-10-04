<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void
    {
        Schema::create('profiles', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('bio')->nullable();
            $table->timestamps();
        });
        Schema::create('audit', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('user');
            $table->foreign('user')->references('id')->on('users');
        });
        Schema::create('legacy_sessions', function (Blueprint $table) {
            $table->string('token');
        });
    }
    public function down(): void
    {
        Schema::dropIfExists('audit');
        Schema::dropIfExists('profiles');
    }
};
