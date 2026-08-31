const created = new Date().toISOString();

export const hello = {
    created,
    method: 'get',
    path: '/hello',
    description: 'Health sample endpoint',
    responseSample: {
        message: 'Hello from local bfast-functions'
    },
    onRequest: (_, response) => {
        response.status(200).json({message: 'Hello from local bfast-functions'});
    }
};
