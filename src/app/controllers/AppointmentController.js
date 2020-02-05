import * as Yup from "yup";
import { startOfHour, parseISO, isBefore, format, subHours } from "date-fns";
import { pt } from "date-fns/locale";
import Appointment from "../models/Appointment";
import User from "../models/User";
import File from "../models/File";
import Notification from "../schemas/Notification";

import CancellationMail from "../jobs/CancellationMail";
import Queue from "../../lib/Queue";

class AppointmentController {
  async index(req, res) {
    const { page = 1 } = req.query;

    const appointements = await Appointment.findAll({
      where: {
        user_id: req.userId,
        canceled_at: null,
      },
      attributes: ["id", "date", "past", "cancelable"],
      order: ["date"],
      limit: 20,
      offset: (page - 1) * 20,
      include: [
        {
          model: User,
          as: "provider",
          attributes: ["id", "name"],
          include: [
            {
              model: File,
              as: "avatar",
              attributes: ["id", "path", "url"],
            },
          ],
        },
      ],
    });

    return res.json(appointements);
  }

  async store(req, res) {
    const schema = Yup.object().shape({
      date: Yup.date().required(),
      provider_id: Yup.number().required(),
    });

    if (!(await schema.isValid(req.body))) {
      return res.status(400).json({ error: "Validation fails" });
    }

    const { provider_id, date } = req.body;

    // Check is provider_id is a provider
    const isProvider = await User.findOne({
      where: { id: provider_id, provider: true },
    });

    if (!isProvider) {
      return res
        .status(401)
        .json({ error: "You can only create appointments with providers" });
    }

    if (provider_id === req.userId) {
      return res
        .status(401)
        .json({ error: "Can not create appointments with yourself" });
    }

    // Valida se a data que o usuário está querendo agendar já não passou
    const hourStart = startOfHour(parseISO(date));

    if (isBefore(hourStart, new Date())) {
      return res.status(400).json({ error: "Past dates are not permitted" });
    }

    // Valida se o provider já não tem um agendamento marcado para o horário que o usuário quer marcar
    const checkAvailability = await Appointment.findOne({
      where: {
        provider_id,
        canceled_at: null,
        date: hourStart,
      },
    });

    if (checkAvailability) {
      return res
        .status(400)
        .json({ error: "Appointmente date is not available" });
    }

    const appointment = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date: hourStart,
    });

    // Notificar o prestador de serviço
    const user = await User.findByPk(req.userId);

    const formattedDate = format(
      hourStart,
      "'dia' dd 'de' MMMM', às' H:mm'h'",
      { locale: pt }
    );

    await Notification.create({
      content: `Novo agendamento de ${user.name} para ${formattedDate}`,
      provider: provider_id,
    });

    return res.json(appointment);
  }

  async delete(req, res) {
    const appointement = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: "provider",
          attributes: ["name", "email"],
        },
        {
          model: User,
          as: "user",
          attributes: ["name"],
        },
      ],
    });

    if (appointement.user_id !== req.userId) {
      return res.status(401).json({
        error: "You do not have permission to cancel this appointment",
      });
    }

    const dateWithSub = subHours(appointement.date, 2);

    if (isBefore(dateWithSub, new Date())) {
      return res
        .status(401)
        .json({ error: "You can only cancel appoitments 2 hours in advance" });
    }

    appointement.canceled_at = new Date();

    await appointement.save();

    await Queue.add(CancellationMail.key, {
      appointement,
    });

    return res.json(appointement);
  }
}

export default new AppointmentController();
