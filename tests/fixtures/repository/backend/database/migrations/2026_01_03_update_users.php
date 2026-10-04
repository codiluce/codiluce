<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->boolean('admin')->default(false);
            $table->string('token')->nullable();
            $table->renameColumn('token', 'api_token');
        });
        if (!Schema::hasColumn('users', 'nickname')) {
            Schema::table('users', fn (Blueprint $table) => $table->string('nickname')->nullable());
        }
        Schema::dropIfExists('legacy_sessions');
        Schema::table($this->tableName(), function (Blueprint $table) {});
    }
};
