class RoomChannel < ApplicationCable::Channel
  def subscribed
    channel = ::Channel.find_by(slug: params[:slug])
    return reject unless channel

    stream_from Broadcast.stream_for(channel)
  end
end
