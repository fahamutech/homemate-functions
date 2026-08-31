const created = new Date().toISOString();

export const authGuard = {
    created,
    path: '/',
    description: 'Sample guard middleware',
    onGuard: (_, __, next) => {
        next();
    }
};
