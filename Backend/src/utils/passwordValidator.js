const SPECIAL_CHARS = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

export const validatePassword = (password) => {
    if (!password || password.length < 12) {
        return "Password must be at least 12 characters";
    }
    if (!/[A-Z]/.test(password)) {
        return "Password must contain at least one uppercase letter";
    }
    if (!/[a-z]/.test(password)) {
        return "Password must contain at least one lowercase letter";
    }
    if (!/\d/.test(password)) {
        return "Password must contain at least one number";
    }
    if (!SPECIAL_CHARS.test(password)) {
        return "Password must contain at least one special character (!@#$%^&* etc.)";
    }
    return null;
};
