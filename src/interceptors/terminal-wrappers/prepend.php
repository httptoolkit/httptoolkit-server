<?php
    stream_context_set_default(
        array(
            'http' => array('proxy' => 'localhost:8000')
        )
    );
?>