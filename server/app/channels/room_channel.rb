class RoomChannel < ApplicationCable::Channel
  def subscribed
    # Row-level security reads the boundary from the transaction, and a
    # subscription is not a request — so the room is entered around the lookup
    # or the lookup finds nothing. Membership is read in here for the same
    # reason: `memberships` is behind the same boundary, and this gate copied
    # out of `require_channel_access!` and left outside the block would refuse
    # every legitimate subscriber rather than only the ones it means to.
    #
    # The rule itself is that gate's, unchanged: an open room admits anybody in
    # the workspace, a private one admits the people in it. The stream and the
    # record answer one question one way — a socket that answered it more
    # generously is the one that leaks, because nothing about a stream is
    # refused later.
    channel = Workspace.entered(current_workspace) do
      room = ::Channel.find_by(slug: params[:slug])
      room if room && (room.visibility == "open" || current_user.member_of?(room))
    end
    return reject unless channel

    stream_from Broadcast.stream_for(channel)
  end
end
