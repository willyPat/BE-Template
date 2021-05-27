const express = require('express');
const bodyParser = require('body-parser');
const {sequelize, Profile} = require('./model')
const {Op, fn, col} = require('sequelize');
const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * FIX ME!
 * @returns contract by id
 */
app.get('/contracts/:id',getProfile ,async (req, res) =>{
    const {Contract} = req.app.get('models')
    const {id} = req.params
    const {id: profileId} = req.profile 
    try {
        const contract = await Contract.findOne({
            where: {
                id, 
                [Op.or]: [
                    { ClientId: profileId }, 
                    { ContractorId: profileId }
                ]
            }
        })
        if(!contract) return res.status(404).end()
        res.json(contract)
    } catch (error) {
        res.status(500).end()
    }
})

app.get('/contracts/',getProfile ,async (req, res) =>{
    const {Contract} = req.app.get('models')
    const {id: profileId} = req.profile
    try {
        const contracts = await Contract.findAll({
            where: {
                [Op.not]: { status: 'terminated' }, 
                [Op.or]: [
                    { ClientId: profileId }, 
                    { ContractorId: profileId }
                ]
            }
        })
        if(!contracts.length) return res.status(404).end()
        res.json(contracts)    
    } catch (error) {
        res.status(500).end()
    }
})

app.get('/jobs/unpaid',getProfile ,async (req, res) =>{
    const {Job, Contract} = req.app.get('models')
    const {id: profileId} = req.profile
    try {
        const jobs = await Job.findAll({
            include: [{
                attributes: [],
                model: Contract,
                required: true,
                where: {
                    [Op.or]: [
                        { ClientId: profileId }, 
                        { ContractorId: profileId }
                    ]
                }
            }],
            where: {
                paid: null,  // even though default is false it shows up as null
            }
        })
        if(!jobs.length) return res.status(404).end()
        res.json(jobs)  
    } catch (error) {
        res.status(500).end()
    }
})

app.post('/jobs/:job_id/pay',getProfile ,async (req, res) =>{
    const sequelize = req.app.get('sequelize')
    const {Job, Contract, Profile} = req.app.get('models')
    const profile = req.profile
    const {job_id: jobId} = req.params
    if (profile.type !== 'client') return res.status(403).end()
    try {
        const job = await Job.findOne({
            include: [{
                model: Contract,
                required: true,
                where: {ClientId: profile.id}
            }],
            where: {id: jobId}
        })
        if(!job) return res.status(404).end()
        if(profile.balance < job.price) res.status(403).end()
    
        const transaction = await sequelize.transaction() // I want to make sure all payments are made within a transaction
        await Promise.all([
            Job.update({paid: true, paymentDate: new Date()}, {where: {id: jobId}, transaction}),
            Profile.increment('balance', {by: job.price, where: { id: job.Contract.ContractorId}, transaction}),
            Profile.decrement('balance', {by: job.price, where: { id: job.Contract.ClientId}, transaction})
        ])
        await transaction.commit()
        
        res.status(200).end()
    } catch (error) {
        if (transaction) await transaction.rollback()
        return res.status(500).end()
    }
    
})
// Is the userId necessary? I'd think that only the sender (req.profile.id) can deposit in his own account if it's a Client.
app.post('/balances/deposit/:userId', async (req, res) =>{
    const {Job, Contract, Profile} = req.app.get('models')
    const {userId} = req.params
    const {amountToDeposit} = req.body
    try {
        const profile = await Profile.findOne({where: {id: userId}})
        if (profile.type !== 'client') return res.status(403).end()
        const result = await Job.findOne({
            attributes: [[fn('SUM', col('price')), 'toPay']],
            raw: true,
            include: [{
                attributes: [],
                model: Contract,
                required: true,
                where: { ClientId: profile.id }
            }],
            where: {
                paid: null
            },
            group: ['Contract.ClientId']
        })
        if (!result || (amountToDeposit > result.toPay * 1.25)) return res.status(403).end()

        await Profile.increment('balance', {by: amountToDeposit, where: { id: userId}})
        const updatedProfile = await Profile.findOne({where: {id: userId}})

        res.json(updatedProfile)
        
    } catch (error) {
        res.status(500).end()
    }
})

app.get('/admin/best-profession',async (req, res) =>{
    const {start, end} = req.query
    const {Job, Contract} = req.app.get('models')
    try {
        const [result] = await Job.findAll({
            attributes: [[fn('SUM', col('price')), 'totalEarned']],
            include: [{
                model: Contract,
                required: true,
                include: [
                    {
                        model: Profile,
                        required: true,
                        as: 'Contractor'
                    }
                ]
            }],
            where: {
                paymentDate: { [Op.between]: [start, end] },
                paid: true
            },
            group: ['Contract.ContractorId'],
            order: [[col('totalEarned'), 'DESC']],
            limit: 1
        })
        if(!result) return res.status(404).end()
        res.json({
            totalEarned: result.dataValues.totalEarned,
            professional: result.dataValues.Contract.Contractor
        }) 
    } catch (error) {
        res.status(500).end()
    }
})

app.get('/admin/best-clients',async (req, res) =>{
    const {start, end, limit = 2} = req.query
    const {Job, Contract} = req.app.get('models')
    try {
        const results = await Job.findAll({
            raw: true,
            attributes: [[fn('SUM', col('price')), 'totalPaid']],
            include: [{
                model: Contract,
                required: true,
                include: [
                    {
                        model: Profile,
                        required: true,
                        as: 'Client'
                    }
                ]
            }],
            where: {
                paymentDate: { [Op.between]: [start, end] },
                paid: true
            },
            group: ['Contract.ClientId'],
            order: [[col('totalPaid'), 'DESC']],
            limit
        })
        if(!results.length) return res.status(404).end()
        res.json(
            results.map(result => ({
                id: result['Contract.Client.id'],
                paid: result.totalPaid,
                fullName: `${result['Contract.Client.firstName']} ${result['Contract.Client.lastName']}`})
            )
        )
    } catch (error) {
        res.status(500).end()
    }
})

module.exports = app;
