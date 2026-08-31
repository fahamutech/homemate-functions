const created = new Date().toISOString();

export const chatEvent = {
    created,
    name: '/chat',
    description: 'Sample socket event',
    requestSample: {
        message: 'hello world'
    },
    onEvent: ({body}, response) => {
        response.announce({message: body?.message ?? 'hello world'});
    }
};
