//! Password hashing: bcrypt for new passwords; verify supports bcrypt.
//! New passwords are always hashed with bcrypt.

pub fn hash_password(password: &str) -> Result<String, bcrypt::BcryptError> {
    bcrypt::hash(password, bcrypt::DEFAULT_COST)
}

pub fn verify_password(plain: &str, hashed: &str) -> bool {
    if hashed.is_empty() {
        return false;
    }
    if hashed.starts_with("$2") {
        bcrypt::verify(plain, hashed).unwrap_or(false)
    } else {
        // $5$ (sha256_crypt) and other formats: not supported; use bcrypt
        false
    }
}
