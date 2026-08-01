class RoomChannel < ApplicationCable::Channel
  def subscribed
    # Row-level security reads the boundary from the transaction, and a
    # subscription is not a request — so the room is entered around the lookup
    # or the lookup finds nothing.
    channel = Workspace.entered(current_workspace) { ::Channel.find_by(slug: params[:slug]) }
    return reject unless channel

    stream_from Broadcast.stream_for(channel)
  end
end
